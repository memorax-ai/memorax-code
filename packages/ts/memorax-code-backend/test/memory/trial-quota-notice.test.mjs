import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimTrialQuotaNotice } from "../../dist/memory/trial-quota-notice.js";
import {
  parseTrialCredentialRecord,
  serializeTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-record.mjs";
import {
  transitionTrialCredentialRecord,
} from "../../../memorax-code-adapter-common/src/credentials/trial-credential-store.mjs";

const API_KEY = `sk_${"a".repeat(43)}`;
const PLUGIN_MARK = `mk_${"b".repeat(32)}`;
const REGISTER_URL = "https://platform.memorax.net/register";

test("trial quota notices claim lower levels once and reset after replenishment", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-quota-notice-"));
  let stored = serializeTrialCredentialRecord(readyCredential());
  const backend = {
    load: async () => stored,
    save: async (serialized) => { stored = serialized; },
    delete: async () => true,
  };
  const transitionCredential = (operation, options) => transitionTrialCredentialRecord(
    operation,
    { ...options, backend, platform: "linux" },
  );
  const config = { apiKey: API_KEY, credentialSource: "trial" };
  const claim = (remaining) => claimTrialQuotaNotice(
    config,
    { remaining, limit: 10_000 },
    { env: { MEMORAX_CODE_HOME: memoraxCodeHome }, transitionCredential },
  );

  try {
    const concurrent = (await Promise.all([claim(4_800), claim(4_800)])).filter(Boolean);
    assert.equal(concurrent.length, 1);
    assert.match(concurrent[0], /4800 of 10000 remaining/);
    assert.match(concurrent[0], new RegExp(PLUGIN_MARK));
    assert.match(concurrent[0], new RegExp(REGISTER_URL.replaceAll(".", "\\.")));
    assert.doesNotMatch(concurrent[0], new RegExp(API_KEY));
    assert.equal(currentRecord().last_warned_level, 5_000);

    assert.equal(await claim(4_500), undefined);
    assert.equal(currentRecord().last_warned_level, 5_000);

    assert.match(await claim(3_800), /3800 of 10000 remaining/);
    assert.equal(currentRecord().last_warned_level, 4_000);

    assert.equal(await claim(6_000), undefined);
    assert.equal(currentRecord().last_warned_level, null);

    assert.match(await claim(4_900), /4900 of 10000 remaining/);
    assert.equal(currentRecord().last_warned_level, 5_000);
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }

  function currentRecord() {
    return parseTrialCredentialRecord(stored);
  }
});

test("trial quota notice fails open when the secure transition stalls", async () => {
  const diagnostics = [];
  const notice = await claimTrialQuotaNotice(
    { apiKey: API_KEY, credentialSource: "trial" },
    { remaining: 4_800, limit: 10_000 },
    {
      diagnosticLogger: (event) => diagnostics.push(event),
      timeoutMs: 20,
      transitionCredential: async () => new Promise(() => {}),
    },
  );

  assert.equal(notice, undefined);
  assert.deepEqual(diagnostics, ["memorax_quota_notice.update_failed"]);
});

function readyCredential() {
  return {
    version: 1,
    state: "ready",
    plugin_mark: PLUGIN_MARK,
    app_salt: "@memorax/memorax-code@1.0.0",
    machine_id_hash: "c".repeat(64),
    hostname: "test-host",
    platform: "linux",
    arch: "x64",
    mac_hash: "d".repeat(64),
    api_key: API_KEY,
    account_id: "900100000000000001",
    project_id: "900100000000000002",
    warn_remaining_threshold: 5_000,
    warn_remaining_step: 1_000,
    register_url: REGISTER_URL,
    last_warned_level: null,
  };
}
