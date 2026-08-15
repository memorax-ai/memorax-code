import assert from "node:assert/strict";
import test from "node:test";
import {
  mapTrialProvisionResponse,
  TrialProvisionContractError,
} from "../lib/trial-provision-contract.mjs";

const PLUGIN_MARK = `mk_${"a".repeat(32)}`;
const API_KEY = `sk_${"A".repeat(43)}`;
const ENCODED_API_KEY = [...API_KEY]
  .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
  .join("");
const ACCOUNT_ID = "900719925474099300000000001";
const PROJECT_ID = "900719925474099300000000002";

function provisionResponse(overrides = {}) {
  return {
    user_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    api_key: API_KEY,
    key_prefix: "sk_AAAAAAAA",
    plugin_mark: PLUGIN_MARK,
    created: true,
    api_key_recovered: false,
    warn_remaining_threshold: 5000,
    warn_remaining_step: 1000,
    register_url: "https://platform.memorax.net/register",
    ...overrides,
  };
}

function mapResponse(response = provisionResponse()) {
  return mapTrialProvisionResponse(response, {
    expectedPluginMark: PLUGIN_MARK,
    expectedApiKey: API_KEY,
  });
}

test("provision maps wire user_id to isolated accountId fields", () => {
  const mapped = mapResponse();

  assert.deepEqual(mapped, {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    created: true,
    apiKeyRecovered: false,
    warnRemainingThreshold: 5000,
    warnRemainingStep: 1000,
    registerUrl: "https://platform.memorax.net/register",
  });
  assert.equal(Object.hasOwn(mapped, "userId"), false);
  assert.equal(Object.hasOwn(mapped, "memoryUserId"), false);
  assert.equal(JSON.stringify(mapped).includes(API_KEY), false);
});

test("provision preserves PublicIds as decimal strings beyond Number.MAX_SAFE_INTEGER", () => {
  const mapped = mapResponse(provisionResponse({
    user_id: "900719925474099312345678901",
    project_id: "900719925474099312345678902",
  }));

  assert.equal(mapped.accountId, "900719925474099312345678901");
  assert.equal(mapped.projectId, "900719925474099312345678902");
  assert.equal(typeof mapped.accountId, "string");
  assert.equal(typeof mapped.projectId, "string");
});

test("provision rejects malformed account and project IDs", () => {
  for (const [field, value, reason] of [
    ["user_id", 123456789, "invalid_account_id"],
    ["user_id", "", "invalid_account_id"],
    ["user_id", "3415x", "invalid_account_id"],
    ["project_id", null, "invalid_project_id"],
    ["project_id", " 3415 ", "invalid_project_id"],
    ["project_id", "project-3415", "invalid_project_id"],
  ]) {
    assert.throws(
      () => mapResponse(provisionResponse({ [field]: value })),
      (error) => error instanceof TrialProvisionContractError
        && error.code === "TRIAL_PROVISION_RESPONSE_INVALID"
        && error.reason === reason
        && !String(error).includes(API_KEY),
    );
  }
});

test("provision fails closed when echoed mark or API key differs", () => {
  for (const [overrides, reason] of [
    [{ plugin_mark: `mk_${"b".repeat(32)}` }, "plugin_mark_mismatch"],
    [{ api_key: `sk_${"B".repeat(43)}` }, "api_key_mismatch"],
  ]) {
    assert.throws(
      () => mapResponse(provisionResponse(overrides)),
      (error) => error instanceof TrialProvisionContractError
        && error.code === "TRIAL_PROVISION_RESPONSE_INVALID"
        && error.reason === reason
        && !String(error).includes(API_KEY)
        && !String(error).includes(overrides.api_key ?? "not-present"),
    );
  }
});

test("provision validates persisted response fields without rejecting extensions", () => {
  for (const [overrides, reason] of [
    [{ key_prefix: "" }, "invalid_key_prefix"],
    [{ created: "true" }, "invalid_created"],
    [{ api_key_recovered: 1 }, "invalid_api_key_recovered"],
    [{ warn_remaining_threshold: -1 }, "invalid_warn_remaining_threshold"],
    [{ warn_remaining_step: 0 }, "invalid_warn_remaining_step"],
    [{ register_url: "http://platform.memorax.net/register" }, "invalid_register_url"],
    [{ register_url: "https://user:password@platform.memorax.net/register" }, "invalid_register_url"],
    [{ register_url: `https://platform.memorax.net/register?key=${API_KEY}` }, "invalid_register_url"],
    [{ register_url: `https://platform.memorax.net/register?key=${ENCODED_API_KEY}` }, "invalid_register_url"],
  ]) {
    assert.throws(
      () => mapResponse(provisionResponse(overrides)),
      (error) => error instanceof TrialProvisionContractError && error.reason === reason,
    );
  }

  assert.deepEqual(mapResponse(provisionResponse({
    key_prefix: API_KEY,
    created: false,
    api_key_recovered: true,
    future_server_field: "ignored",
  })), {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    created: false,
    apiKeyRecovered: true,
    warnRemainingThreshold: 5000,
    warnRemainingStep: 1000,
    registerUrl: "https://platform.memorax.net/register",
  });
});
